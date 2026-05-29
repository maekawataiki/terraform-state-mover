data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "tf-state-111111111111"
    key    = "network/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_eks_cluster" "main" {
  name     = "platform-cluster"
  role_arn = aws_iam_role.eks_cluster.arn
  vpc_config {
    subnet_ids = data.terraform_remote_state.network.outputs.private_subnet_ids
  }
}

resource "aws_iam_role" "eks_cluster" {
  name               = "platform-eks-cluster-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "service_deployer" {
  name               = "platform-service-deployer"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "lambda_base" {
  name               = "platform-lambda-base-role"
  assume_role_policy = "{}"
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "deployer_role_arn" {
  value = aws_iam_role.service_deployer.arn
}
