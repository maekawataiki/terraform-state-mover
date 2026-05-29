resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_eks_cluster" "prod" {
  name     = "prod-cluster"
  role_arn = "arn:aws:iam::111111111111:role/eks-cluster-role"
  vpc_config {
    subnet_ids = []
  }
}
