variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "min_size" {
  type = number
}

variable "max_size" {
  type = number
}

variable "desired_capacity" {
  type = number
}

variable "ami_id" {
  type = string
}

variable "key_name" {
  type = string
}

variable "iam_role_arn" {
  type = string
}

variable "certificate_arn" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "hosted_zone_id" {
  type = string
}

variable "log_bucket" {
  type = string
}

resource "aws_ecs_cluster" "mega" {
  name = var.cluster_name
}
